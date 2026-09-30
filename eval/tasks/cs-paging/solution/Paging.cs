namespace Demo;

public static class Paging
{
    public static int PageCount(int totalItems, int pageSize)
    {
        if (pageSize <= 0) throw new ArgumentOutOfRangeException(nameof(pageSize));
        return (totalItems + pageSize - 1) / pageSize;
    }
}
